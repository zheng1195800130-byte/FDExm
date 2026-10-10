Set fdeShell = CreateObject("WScript.Shell")
Set fdeFiles = CreateObject("Scripting.FileSystemObject")
fdeRoot = fdeFiles.GetParentFolderName(WScript.ScriptFullName)
fdeShell.CurrentDirectory = fdeRoot
Set fdeEnv = fdeShell.Environment("PROCESS")
fdeElectron = fdeRoot & "\node_modules\electron\dist\electron.exe"
fdePortable = fdeRoot & "\release\FDE Desk-win32-x64\FDE Desk.exe"
If fdeFiles.FileExists(fdeElectron) Then
  ' Use the same data-aware launcher as npm start, without a console window.
  fdeEnv("ELECTRON_RUN_AS_NODE") = "1"
  fdeShell.Run Chr(34) & fdeElectron & Chr(34) & " " & Chr(34) & fdeRoot & "\scripts\start.cjs" & Chr(34), 0, False
ElseIf fdeFiles.FileExists(fdePortable) Then
  fdeEnv.Remove "ELECTRON_RUN_AS_NODE"
  fdeShell.Run Chr(34) & fdePortable & Chr(34), 0, False
Else
  MsgBox "FDE Desk executable was not found. Please restore the application folder.", 48, "FDE Desk"
End If
