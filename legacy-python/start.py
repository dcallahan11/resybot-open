import os
import subprocess
import sys
import time
import signal

def run_server():
    os.chdir("server")
    server_process = subprocess.Popen([sys.executable, "server.py"])
    os.chdir("..")
    return server_process

def run_client():
    os.chdir("client")
    client_process = subprocess.Popen([sys.executable, "entry.py"])
    os.chdir("..")
    return client_process

def cleanup(server_process, client_process):
    print("\nShutting down...")
    server_process.terminate()
    client_process.terminate()
    server_process.wait()
    client_process.wait()
    print("Successfully shut down all processes.")

if __name__ == "__main__":
    print("Starting ResyGrabber...")
    print("Starting server...")
    server_process = run_server()
    
    # Wait for server to start
    print("Waiting for server to start (3 seconds)...")
    time.sleep(3)
    
    print("Starting client...")
    client_process = run_client()
    
    try:
        # Wait for the client to exit
        client_process.wait()
    except KeyboardInterrupt:
        pass
    finally:
        cleanup(server_process, client_process) 