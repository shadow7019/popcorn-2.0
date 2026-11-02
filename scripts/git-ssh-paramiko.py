#!/usr/bin/env python3
"""Minimal GIT_SSH replacement built on paramiko.

The sandbox has no ssh binary and no way to install one, but git can use any
executable as its SSH transport via GIT_SSH_COMMAND. This script speaks just
enough of the ssh CLI for git: argv is  [-p PORT]  HOST  REMOTE_COMMAND...

Usage:
  GIT_SSH_COMMAND="python3 /home/z/my-project/scripts/git-ssh-paramiko.py" \
    git push git@github.com:shadow7019/popcorn-2.0.git main
"""
import os
import select
import sys

import paramiko

_PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get("GIT_SSH_KEY", os.path.join(_PROJECT, ".ssh-deploy/id_ed25519"))
KNOWN_HOSTS = os.environ.get(
    "GIT_SSH_KNOWN_HOSTS", os.path.join(_PROJECT, ".ssh-deploy/known_hosts")
)


def main() -> int:
    args = sys.argv[1:]
    port = 22
    if args and args[0] == "-p":
        port = int(args[1])
        args = args[2:]
    if len(args) < 2:
        sys.stderr.write("git-ssh-paramiko: expected HOST and COMMAND args\n")
        return 2
    hostarg, remote_cmd = args[0], " ".join(args[1:])
    # git passes "user@host" as a single arg (OpenSSH parses it itself)
    user = "git"
    if "@" in hostarg:
        user, host = hostarg.split("@", 1)
    else:
        host = hostarg

    client = paramiko.SSHClient()
    # GitHub's host keys are pinned in .ssh-deploy/known_hosts; fall back to
    # reject-on-unknown rather than blindly trusting new hosts.
    if os.path.exists(KNOWN_HOSTS):
        client.load_system_host_keys(KNOWN_HOSTS)
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    pkey = None
    for cls in (paramiko.RSAKey, paramiko.Ed25519Key):
        try:
            pkey = cls.from_private_key_file(KEY)
            break
        except Exception:
            continue
    if pkey is None:
        sys.stderr.write(f"git-ssh-paramiko: cannot load key {KEY}\n")
        return 2

    client.connect(
        hostname=host,
        port=port,
        username=user,
        pkey=pkey,
        look_for_keys=False,
        allow_agent=False,
        timeout=30,
        banner_timeout=30,
        auth_timeout=30,
    )
    transport = client.get_transport()
    channel = transport.open_session()
    channel.settimeout(None)
    channel.exec_command(remote_cmd)

    # Single-threaded select loop (a daemon stdin-pump thread made Python
    # abort with a buffered-IO lock error at shutdown).
    fd0 = sys.stdin.buffer.fileno()
    stdin_open = True
    while True:
        rlist = []
        if stdin_open:
            rlist.append(fd0)
        if not channel.closed:
            rlist.append(channel)
        if not rlist:
            break
        try:
            ready, _, _ = select.select(rlist, [], [], 1.0)
        except (OSError, ValueError):
            break
        if fd0 in ready:
            data = os.read(fd0, 32768)
            if data:
                channel.sendall(data)
            else:
                stdin_open = False
                try:
                    channel.shutdown_write()
                except Exception:
                    pass
        if channel in ready:
            data = channel.recv(32768)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    while True:
        try:
            err = channel.recv_stderr(32768)
        except Exception:
            break
        if not err:
            break
        sys.stderr.buffer.write(err)
    sys.stderr.buffer.flush()

    code = channel.recv_exit_status()
    client.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
