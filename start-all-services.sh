#!/bin/bash

echo "========================================"
echo "Starting All Attendance System Services"
echo "========================================"
echo ""

# Function to start service in new terminal
start_service() {
    local name=$1
    local port=$2
    local command=$3
    
    echo "Starting $name (Port $port)..."
    
    # Try different terminal emulators
    if command -v gnome-terminal &> /dev/null; then
        gnome-terminal -- bash -c "echo '$name - Port $port'; $command; exec bash"
    elif command -v xterm &> /dev/null; then
        xterm -title "$name - Port $port" -e "$command; bash" &
    elif command -v konsole &> /dev/null; then
        konsole --title "$name - Port $port" -e bash -c "$command; exec bash" &
    else
        # Fallback: run in background
        echo "No terminal emulator found. Running in background..."
        $command &
    fi
    
    sleep 3
}

# Start all services
start_service "Main Service" "4500" "npm start"
start_service "Mark Service" "5001" "npm run start:mark"
start_service "Verify Service" "5002" "npm run start:verify"
start_service "Register Service" "5003" "npm run start:register"

echo ""
echo "========================================"
echo "All services started!"
echo "========================================"
echo "Main Service:     http://localhost:4500"
echo "Mark Service:     http://localhost:5001"
echo "Verify Service:   http://localhost:5002"
echo "Register Service: http://localhost:5003"
echo "========================================"
echo ""
echo "Press Ctrl+C to exit"
wait

