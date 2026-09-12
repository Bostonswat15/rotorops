@echo off
REM Launch RotorOps from anywhere.
REM
REM %~dp0 is the folder this file lives in, so the working directory is right
REM no matter where the command was typed. `call` matters too: npm is itself a
REM .bat, and without it this script would exit at the npm line.
cd /d "%~dp0"
call npm --prefix desktop start
