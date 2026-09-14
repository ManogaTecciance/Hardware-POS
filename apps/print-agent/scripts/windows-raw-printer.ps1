# D181 — RAW bytes to a Windows-installed printer, by its Windows name.
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
  # RAW = bytes straight to the device (ESC/POS). TEXT = the file is plain
  # text, rendered as a page through the printer's driver, which is how an
  # office printer prints a ticket (D181).
  [ValidateSet("RAW","TEXT")][string]$DataType = "RAW"
)

# A failure here must be an exit code, not a red line on stderr: the agent
# reads only the exit code, and a 0 after a thrown exception was reported to
# the queue as "printed" while the printer sat idle (Canon G3010, 2026-09-14).
$ErrorActionPreference = "Stop"
trap {
  [Console]::Error.WriteLine("windows-raw-printer: $($_.Exception.Message)")
  exit 1
}

# TEXT does NOT go through winspool's "TEXT" datatype. That datatype is a
# service of the driver's print processor, and the v4 / class drivers Windows
# installs on its own for a network printer (e.g. "Microsoft IPP Class Driver")
# refuse it: StartDocPrinter fails and nothing prints. Out-Printer renders the
# text through GDI like any application would, so it prints on whatever driver
# the printer has — vendor, class or Generic / Text Only.
if ($DataType -eq "TEXT") {
  if (-not (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue)) {
    throw "printer '$PrinterName' is not installed on this machine"
  }
  Get-Content -LiteralPath $FilePath -Raw -Encoding UTF8 | Out-Printer -Name $PrinterName
  exit 0
}

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
