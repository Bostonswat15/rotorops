@echo off
REM Launch RotorOps from anywhere.
REM
REM %~dp0 is the folder this file lives in, so the working directory is right
REM no matter where the command was typed. `call` matters too: npm is itself a
REM .bat, and without it this script would exit at the npm line.
REM
REM `rotorops reveal` prints the hidden casualty position when a search
REM contract arms. For testing a search without flying the whole sweep.
if /I "%~1"=="reveal" (
  set ROTOROPS_REVEAL=1
  echo Reveal mode: the casualty position will be printed when a search arms.
)
cd /d "%~dp0"
call npm --prefix desktop start
