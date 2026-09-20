#!/usr/bin/env python3
import os
import sys
import pty
import fcntl
import termios
import struct
import select
import json
import signal

def set_terminal_size(fd, rows, cols):
    try:
        s = struct.pack("HHHH", int(rows), int(cols), 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, s)
    except Exception:
        pass

def main():
    shell = os.environ.get("SHELL")
    if not shell or not os.path.exists(shell):
        for candidate in ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]:
            if os.path.exists(candidate):
                shell = candidate
                break
    if not shell:
        shell = "/bin/sh"

    rows = int(os.environ.get("LINES", 24))
    cols = int(os.environ.get("COLUMNS", 80))

    master_fd, slave_fd = pty.openpty()
    set_terminal_size(master_fd, rows, cols)

    pid = os.fork()
    if pid == 0:
        os.close(master_fd)
        os.setsid()
        try:
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        except Exception:
            pass
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        os.execvpe(shell, [shell, "-i"], env)
        sys.exit(1)

    os.close(slave_fd)

    def sigchld_handler(signum, frame):
        pass

    signal.signal(signal.SIGCHLD, sigchld_handler)

    stdin_fd = sys.stdin.fileno()

    for fd in [stdin_fd, master_fd]:
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    try:
        while True:
            rlist, _, _ = select.select([stdin_fd, master_fd], [], [], 0.05)

            ret = os.waitpid(pid, os.WNOHANG)
            if ret != (0, 0):
                break

            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 4096)
                    if data:
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    else:
                        break
                except (OSError, BlockingIOError):
                    pass

            if stdin_fd in rlist:
                try:
                    chunk = sys.stdin.buffer.read(4096)
                    if not chunk:
                        break
                    
                    if b'"type":"resize"' in chunk or b'"type": "resize"' in chunk:
                        try:
                            text = chunk.decode("utf-8", errors="ignore")
                            lines = text.strip().split("\n")
                            remaining_bytes = b""
                            for line in lines:
                                if line.startswith("{") and line.endswith("}"):
                                    cmd = json.loads(line)
                                    if cmd.get("type") == "resize":
                                        new_cols = cmd.get("cols", 80)
                                        new_rows = cmd.get("rows", 24)
                                        set_terminal_size(master_fd, new_rows, new_cols)
                                        continue
                                remaining_bytes += line.encode("utf-8")
                            if remaining_bytes:
                                os.write(master_fd, remaining_bytes)
                            continue
                        except Exception:
                            pass

                    os.write(master_fd, chunk)
                except (OSError, BlockingIOError):
                    pass

    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.close(master_fd)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

if __name__ == "__main__":
    main()
