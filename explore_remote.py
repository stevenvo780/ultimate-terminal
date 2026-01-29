import pexpect
import sys

HOST = "148.230.88.162"
USER = "humanizar"
PASS = "zxcvFDSA90%"
CMD = "docker ps -a"

print(f"Connecting to {USER}@{HOST}...")
child = pexpect.spawn(f"ssh -o StrictHostKeyChecking=no {USER}@{HOST} '{CMD}'")

i = child.expect(['password:', pexpect.EOF, pexpect.TIMEOUT])
if i == 0:
    print("Sending password...")
    child.sendline(PASS)
    child.expect(pexpect.EOF)
    print("Output:")
    print(child.before.decode('utf-8'))
elif i == 1:
    print("EOF received. Buffer:")
    print(child.before.decode('utf-8'))
else:
    print("Timeout")
    child.close()
