import argparse
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEALTH = 'http://127.0.0.1:35639/health'

def ready():
    try:
        with urllib.request.urlopen(HEALTH, timeout=1) as response:
            value = json.loads(response.read(8192))
            return value.get('application') == 'fde-desk-easyclaw'
    except Exception:
        return False

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default='{}')
    parser.add_argument('--method', default='start')
    parser.parse_known_args()
    executable = ROOT / 'native' / 'FDE Desk.exe'
    if not executable.is_file():
        raise RuntimeError('本地工作服务程序缺失，请重新同步应用。')
    if not ready():
        environment = dict(os.environ)
        for name in ['ELECTRON_RUN_AS_NODE', 'FDE_DATA_DIR', 'FDE_TEST']:
            environment.pop(name, None)
        subprocess.Popen([str(executable), '--easyclaw-host'], cwd=str(executable.parent), env=environment,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        for _ in range(60):
            if ready():
                break
            time.sleep(0.2)
    if not ready():
        raise RuntimeError('本地工作服务未就绪，请检查账号授权或重新打开应用。')
    print(json.dumps({'result': True, 'data': {'ready': True}}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'result': False, 'error': str(error)}, ensure_ascii=False))
