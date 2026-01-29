import pty
import os
import sys
import subprocess
import select

PASS = "zxcvFDSA90%"
HOST = "humanizar@148.230.88.162"

def run_ssh_cmd(args):
    print(f"\n[CMD] {' '.join(args)}")
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(args[0], args)
    else:
        password_sent = False
        while True:
            try:
                r, w, x = select.select([fd], [], [], 1)
                if fd in r:
                    chunk = os.read(fd, 1024)
                    if not chunk: break
                    text = chunk.decode(errors='ignore')
                    sys.stdout.write(text)
                    sys.stdout.flush()
                    
                    if "assword" in text or "d:" in text: # Matches 'password:' or '[sudo] password for...'
                        # Simple debounce logic or state check could be better, but sending blindly usually works in pty
                        # unless echo is on, which creates loop. 
                        # Usually SSH disables echo for password.
                        # We send password + enter.
                        os.write(fd, (PASS + "\n").encode())
                        # time.sleep(0.5) 
            except OSError:
                break
        os.waitpid(pid, 0)

def main():
    # 1. Prepare stage
    print("[1/3] Preparing payload...")
    os.system("rm -rf deploy_stage payload.tar.gz")
    os.system("mkdir -p deploy_stage")
    if os.system("cp nexus/bin/nexus-linux deploy_stage/") != 0:
        print("Failed to copy binary")
        return
    if os.system("cp -r nexus/public deploy_stage/") != 0:
        print("Failed to copy public")
        return
    
    os.system("tar -czf payload.tar.gz -C deploy_stage .")
    print(f"Payload created: {os.path.getsize('payload.tar.gz')} bytes")

    # 2. Upload
    print("[2/3] Uploading...")
    run_ssh_cmd(["scp", "-o", "StrictHostKeyChecking=no", "payload.tar.gz", f"{HOST}:/tmp/payload.tar.gz"])

    # 3. Exec Remote
    print("[3/3] Installing...")
    # Using 'echo' to pipe password to sudo if needed? No, sudo reads from tty.
    # We rely on the pty handler to feed password to sudo if prompted.
    commands = [
        "echo 'Starting remote update...'",
        "sudo systemctl stop ultimate-terminal-nexus || echo 'Service warn'",
        "mkdir -p /tmp/ut_update",
        "tar -xzf /tmp/payload.tar.gz -C /tmp/ut_update",
        "sudo cp /tmp/ut_update/nexus-linux /usr/bin/ultimate-terminal-nexus",
        "sudo chmod +x /usr/bin/ultimate-terminal-nexus",
        "sudo rm -rf /usr/share/ultimate-terminal/public",
        "sudo cp -r /tmp/ut_update/public /usr/share/ultimate-terminal/",
        "sudo chown -R utnexus:utnexus /usr/share/ultimate-terminal || echo 'chown warn'", 
        "sudo systemctl start ultimate-terminal-nexus",
        "echo 'DEPLOYMENT FINISHED'",
        "rm -rf /tmp/ut_update /tmp/payload.tar.gz"
    ]
    
    remote_script = " && ".join(commands)
    # Force pseudo-terminal allocation (-t) so sudo asks for password interactively
    run_ssh_cmd(["ssh", "-tt", "-o", "StrictHostKeyChecking=no", HOST, remote_script])

if __name__ == "__main__":
    main()
