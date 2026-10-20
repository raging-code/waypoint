pkill -f run.py
cat > ~/gpscheck.py <<'EOF'
import serial, time
s = serial.Serial('/dev/ttyAMA0', 9600, timeout=1)
start = time.time(); last = 0; best = 0; used = '0'; fix = '0'
while time.time() - start < 900:
    l = s.readline().decode(errors='ignore')
    if 'GSV' in l:
        f = l.split(',')
        if len(f) > 3 and f[3].isdigit():
            best = max(best, int(f[3]))
    elif 'GGA' in l:
        q = l.split(',')
        if len(q) > 7:
            used, fix = q[7], q[6]
    if time.time() - last >= 10:
        print(f"{int(time.time()-start):4d}s  in view: {best}  used: {used}  fix: {fix}", flush=True)
        last = time.time(); best = 0
EOF