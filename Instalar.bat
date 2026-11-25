@echo off
rem Instalador de Custom Badge by Kazu: descarga y ejecuta install.ps1 desde GitHub.
rem Puedes abrir install.ps1 con el Bloc de notas para ver exactamente lo que hace.
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/joelbooris26-del/CustomBadgeByKazu/main/install.ps1)))"
pause
