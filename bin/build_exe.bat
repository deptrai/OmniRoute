@echo off
chcp 65001 >nul
echo ============================================
echo  Build cookie_converter.exe (PyInstaller)
echo ============================================
echo.

pip install pyinstaller
pyinstaller --onefile --name cookie_converter cookie_converter.py

echo.
echo Done! file exe nam tai: dist\cookie_converter.exe
echo Copy dist\cookie_converter.exe ra desktop roi chay:
echo   cookie_converter.exe input.txt
pause
