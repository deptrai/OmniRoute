@echo off
chcp 65001 >nul
setlocal

if "%~1"=="" (
    echo Usage: cookie_converter.bat input.txt
    echo Output: output.txt
    exit /b 1
)

python "%~dp0cookie_converter.py" "%~1"
if errorlevel 1 exit /b 1

echo.
echo Done. Ket qua: output.txt
endlocal
