#!/usr/bin/env python3
"""Fetch pinned MIT games and create standard FAT12 Atari ST AUTO floppy images.

No proprietary TOS or commercial disk image is required. Both games retain their
upstream license next to the generated image. Downloads are checked before use.
"""
import hashlib
import json
from pathlib import Path
import struct
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2] / 'build' / 'fixtures'
GAMES = [
    ('core', 'flindholm-lab/CORE', '9bdd939525c0e7d36e8015164dae0e81365fe2f0',
     'core.prg', 'dd49be239f08e621aeea8e65ca8ce5dcf49bf3413cf716d4541145fb51d906de'),
    ('arsh', 'jvaneg/ARSH', 'c6eab54bec50802838e3abc0bc38795c8e7e20d5',
     'DEP_ARSH.TOS', '11649006484537aa502ce504e57477e268fbd8d77aa13a86896bd13533105aff'),
]


def floppy(program):
    image = bytearray(720 * 1024)
    image[:11] = b'\xeb\x3c\x90REBITST '
    struct.pack_into('<HBHBHHBHHHII', image, 11, 512, 2, 1, 2, 112, 1440, 0xf9, 3, 9, 2, 0, 0)
    fat = bytearray(3 * 512)
    fat[:3] = b'\xf9\xff\xff'

    def set_fat(cluster, value):
        offset = cluster + cluster // 2
        current = struct.unpack_from('<H', fat, offset)[0]
        current = (current & 0x000f) | (value << 4) if cluster % 2 else (current & 0xf000) | value
        struct.pack_into('<H', fat, offset, current)

    def entry(name, attribute, cluster, size):
        value = bytearray(32)
        value[:11] = name
        value[11] = attribute
        struct.pack_into('<HHHI', value, 22, 0, ((2026-1980) << 9) | (1 << 5) | 1, cluster, size)
        return value

    root = 7 * 512
    data = 14 * 512
    image[root:root+32] = entry(b'AUTO       ', 0x10, 2, 0)
    image[data:data+32] = entry(b'.          ', 0x10, 2, 0)
    image[data+32:data+64] = entry(b'..         ', 0x10, 0, 0)
    image[data+64:data+96] = entry(b'GAME    PRG', 0x20, 3, len(program))
    set_fat(2, 0xfff)
    count = (len(program) + 1023) // 1024
    if data + 1024 + len(program) > len(image):
        raise ValueError('Fixture is too large for this floppy')
    for i in range(count):
        set_fat(3+i, 0xfff if i == count-1 else 4+i)
    image[data+1024:data+1024+len(program)] = program
    image[512:4*512] = fat
    image[4*512:7*512] = fat
    return image


ROOT.mkdir(parents=True, exist_ok=True)
manifest = []
for name, repository, revision, filename, expected in GAMES:
    base = f'https://raw.githubusercontent.com/{repository}/{revision}/'
    with urlopen(base + filename, timeout=30) as response:
        program = response.read()
    assert hashlib.sha256(program).hexdigest() == expected, f'{name}: game download changed'
    for asset in ['LICENSE', 'README.md']:
        with urlopen(base + asset, timeout=30) as response:
            (ROOT / f'{name}.{asset}').write_bytes(response.read())
    image = floppy(program)
    (ROOT / f'{name}.st').write_bytes(image)
    manifest.append(dict(game=name, repository=repository, revision=revision, license='MIT',
                         program_sha256=expected, disk_sha256=hashlib.sha256(image).hexdigest()))
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
