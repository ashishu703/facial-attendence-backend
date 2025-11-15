@echo off
echo ========================================
echo Starting All Attendance System Services
echo ========================================
echo.

REM Open new terminal windows for each service
echo Starting Main Service (Port 4500)...
start "Main Service - Port 4500" cmd /k "npm start"

timeout /t 3 /nobreak >nul

echo Starting Mark Service (Port 5001)...
start "Mark Service - Port 5001" cmd /k "npm run start:mark"

timeout /t 3 /nobreak >nul

echo Starting Verify Service (Port 5002)...
start "Verify Service - Port 5002" cmd /k "npm run start:verify"

timeout /t 3 /nobreak >nul

echo Starting Register Service (Port 5003)...
start "Register Service - Port 5003" cmd /k "npm run start:register"

echo.
echo ========================================
echo All services started!
echo ========================================
echo Main Service:     http://localhost:4500
echo Mark Service:     http://localhost:5001
echo Verify Service:   http://localhost:5002
echo Register Service: http://localhost:5003
echo ========================================
echo.
echo Press any key to close this window...
pause >nul

