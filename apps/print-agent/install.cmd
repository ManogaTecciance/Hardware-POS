@echo off
rem AxloPOS print agent installer launcher (D183).
rem PowerShell refuses an unsigned script from a downloaded zip under the
rem default RemoteSigned policy; -ExecutionPolicy Bypass applies to this run
rem only and changes nothing on the machine. install.ps1 asks for admin itself.
rem Usage: double-click, or   install.cmd -Uninstall   /   install.cmd -Token pat_...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
