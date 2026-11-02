import json, os, sys, urllib.request, urllib.error

cfg = os.path.expanduser('~/.antideploy/config.json')
token = json.load(open(cfg))['token']
name = 'my-project'

req = urllib.request.Request(
    'https://antideploy.com/api/v1/applications',
    data=json.dumps({'name': name}).encode(),
    headers={'content-type': 'application/json', 'authorization': f'Bearer {token}'},
    method='POST')
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        app = json.load(r)
except urllib.error.HTTPError as e:
    body = e.read().decode()
    try:
        err = json.loads(body)
    except Exception:
        err = {}
    # 409 name_taken carries the existing applicationId: reuse it
    if e.code == 409:
        app = err
    else:
        print('FAILED', e.code, body[:500])
        sys.exit(1)

app_id = app.get('applicationId') or app.get('id')
if not app_id:
    print('NO_APPLICATION_ID in response:', json.dumps(app)[:500])
    sys.exit(1)

with open('.antideploy.json', 'w') as f:
    json.dump({'applicationId': app_id}, f, indent=2)
    f.write('\n')

print('application:', app.get('name', name))
print('applicationId:', app_id)
print('subdomain:', app.get('subdomain') or '(derived from name on first deploy)')
print('dashboard:', app.get('dashboard', ''))
print('summary:', app.get('summary', ''))
