' Toneferry hidden launcher: starts the stream server with NO console window.
' Skips silently if port 3088 is already listening.
' Requires: Node.js (>=18) installed and "node" available in PATH.
Option Explicit
Dim shell, fso, tmp, srcDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
srcDir = fso.GetParentFolderName(WScript.ScriptFullName)

tmp = shell.ExpandEnvironmentStrings("%TEMP%") & "\toneferry_port.txt"
shell.Run "cmd /c netstat -ano | findstr "":3088"" | findstr ""LISTENING"" > """ & tmp & """", 0, True
If fso.FileExists(tmp) Then
  If fso.GetFile(tmp).Size > 0 Then WScript.Quit  ' already running, do nothing
End If

shell.Run "cmd /c cd /d """ & srcDir & """ && node server\index.js > server.log 2>&1", 0, False
