' Toneferry stopper: kills the node process listening on port 3088 only
' (never touches other node processes).
Option Explicit
Dim shell, fso, tmp, ts, line, parts, i, pid
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

tmp = shell.ExpandEnvironmentStrings("%TEMP%") & "\toneferry_port.txt"
shell.Run "cmd /c netstat -ano | findstr "":3088"" | findstr ""LISTENING"" > """ & tmp & """", 0, True
If Not fso.FileExists(tmp) Then WScript.Quit
If fso.GetFile(tmp).Size = 0 Then WScript.Quit

Set ts = fso.OpenTextFile(tmp, 1)
line = Trim(ts.ReadLine)
ts.Close

parts = Split(line, " ")
pid = ""
For i = UBound(parts) To 0 Step -1
  If Len(parts(i)) > 0 Then
    pid = parts(i)
    Exit For
  End If
Next

If pid <> "" Then
  shell.Run "taskkill /PID " & pid & " /F", 0, True
End If
