#!/usr/bin/env python3
"""Bound one owned build/test process while preserving output and its failure."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, required=True)
    parser.add_argument('--log', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or args.seconds <= 0:
        parser.error('A command and positive timeout are required')
    path = Path(args.log)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w') as log:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, errors='replace', start_new_session=True)

        def copy_output():
            for line in child.stdout:
                log.write(line)
                log.flush()
                sys.stdout.write(line)
                sys.stdout.flush()

        reader = threading.Thread(target=copy_output, daemon=True)
        reader.start()
        try:
            code = child.wait(timeout=args.seconds)
        except subprocess.TimeoutExpired:
            message = f'Owned test/build exceeded {args.seconds}s; preserving failure and stopping its process group.\n'
            log.write(message)
            log.flush()
            sys.stderr.write(message)
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
            # The leader can exit on TERM while a descendant ignores it.
            # Always finish cleaning our own session/process group, even when
            # wait() reaped the leader successfully.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            code = 124
        reader.join(timeout=5)
        return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())
