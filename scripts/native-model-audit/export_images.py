#!/usr/bin/env python3
"""Copy untouched native PNG attachments into a small human-named evidence set."""
import hashlib
import json
import pathlib
import re
import shutil
import sys

output = pathlib.Path(sys.argv[1])
manifest = output / 'attachments' / 'manifest.json'
if not manifest.exists():
    print('No native attachment manifest to export')
    raise SystemExit(0)
images = output / 'images'
images.mkdir(exist_ok=True)
index = []
for test in json.loads(manifest.read_text()):
    for item in test.get('attachments', []):
        filename = pathlib.Path(item['exportedFileName']).name
        if not filename.lower().endswith('.png'):
            continue
        source = output / 'attachments' / filename
        title = item.get('suggestedHumanReadableName', filename).split('_0_')[0]
        title = re.sub(r'[^\w .()-]+', '-', title).strip(' .')
        name = title if title.endswith('.png') else title + '.png'
        destination = images / name
        if destination.exists():
            destination = images / (pathlib.Path(name).stem + '-' + pathlib.Path(filename).stem + '.png')
        shutil.copyfile(source, destination)
        index.append({'name': title, 'file': destination.name, 'test': test.get('testIdentifier'),
                      'nativeDevice': item.get('deviceName'),
                      'associatedWithFailure': item.get('isAssociatedWithFailure', False),
                      'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
(images / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')
print(f'Exported {len(index)} untouched native PNGs to {images}')
