"""SSH forced-command dispatcher: no shell, SFTP or caller-selected paths."""
import os
import sys
from pathlib import Path

if len(sys.argv) != 3 or sys.argv[1] != '--config' or not Path(sys.argv[2]).is_absolute():
    sys.exit(1)
root=Path(__file__).resolve().parent
command=os.environ.get('SSH_ORIGINAL_COMMAND')
if command=='channel-blog-submit':
    args=['/usr/bin/python3',str(root/'relay.py'),'--config',sys.argv[2],'--operation','submit','--ssh']
elif command=='channel-blog-images':
    args=['/usr/bin/python3',str(root/'image_relay.py'),'--config',sys.argv[2],'--receive']
else:
    print('Only the configured draft and image commands are allowed.',file=sys.stderr);sys.exit(1)
os.execv('/usr/bin/python3',args)
