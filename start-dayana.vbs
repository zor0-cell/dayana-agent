Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c node e:\dayana-agent\index.js >> e:\dayana-agent\dayana.log 2>&1", 0, False
Set shell = Nothing
