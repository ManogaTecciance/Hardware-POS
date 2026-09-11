# D174 — RAW bytes to a Windows-installed printer, by its Windows name.
#
# A USB thermal printer on Windows has no device path a Node process can
# open; the spooler owns it. This hands the spooler a RAW document through
# winspool.drv (OpenPrinter / StartDocPrinter with pDataType "RAW" /
# WritePrinter), which passes ESC/POS through unaltered — no driver rendering,
# no page setup, no dialog. The printer's driver should be the vendor's or
# "Generic / Text Only"; either accepts RAW.
#
# Invoked by the agent's `sendToPrinter` for ESC_POS_USB targets on win32,
# with the printer's Windows name as the address ("POS-80"). Standalone use:
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows-raw-printer.ps1 -PrinterName "POS-80" -FilePath ticket.bin
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$FilePath,
  # RAW = bytes straight to the device (ESC/POS). TEXT = the spooler's print
  # processor lays the file out as plain text through the printer's driver,
  # which is how an office printer prints a ticket (D174).
  [ValidateSet("RAW","TEXT")][string]$DataType = "RAW"
)

$source = @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In] DOCINFOA di);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static void SendFile(string printerName, string filePath, string dataType)
    {
        byte[] bytes = File.ReadAllBytes(filePath);
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");

        try
        {
            var di = new DOCINFOA { pDocName = "AxloPOS", pDataType = dataType, pOutputFile = null };
            if (!StartDocPrinter(hPrinter, 1, di))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
            try
            {
                if (!StartPagePrinter(hPrinter))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
                try
                {
                    IntPtr unmanaged = Marshal.AllocCoTaskMem(bytes.Length);
                    try
                    {
                        Marshal.Copy(bytes, 0, unmanaged, bytes.Length);
                        int written;
                        if (!WritePrinter(hPrinter, unmanaged, bytes.Length, out written))
                            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed");
                        if (written != bytes.Length)
                            throw new IOException("Incomplete RAW print write: " + written + "/" + bytes.Length);
                    }
                    finally { Marshal.FreeCoTaskMem(unmanaged); }
                }
                finally { EndPagePrinter(hPrinter); }
            }
            finally { EndDocPrinter(hPrinter); }
        }
        finally { ClosePrinter(hPrinter); }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
[RawPrinterHelper]::SendFile($PrinterName, $FilePath, $DataType)
