import sys
def patch(path, before, after, label, marker):
    with open(path, encoding='utf-8') as f: c = f.read()
    if before not in c:
        print(('✅ ' + label + ': مطبّق مسبقاً') if marker in c else ('❌ ' + label + ': ما لقيت نقطة الإدراج'))
        if marker not in c: sys.exit(1)
        return
    c = c.replace(before, after, 1)
    with open(path, 'w', encoding='utf-8') as f: f.write(c)
    print('✅ ' + label + ': تم')

patch('handlers/music.js',
"""      [`ytsearch5:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--quiet'],""",
"""      [`ytsearch5:${query}`, '--dump-json', '--flat-playlist', '--no-warnings', '--quiet',
       '--extractor-args', 'youtube:player_client=android,web'],""",
  "music.js (ytSearch: android client)", "player_client=android,web")

patch('handlers/music.js',
"""      '--no-playlist', '--quiet', '--no-warnings',
      '--max-filesize', '45m',
    ], { timeout: DL_TIMEOUT }, (err) => {""",
"""      '--no-playlist', '--quiet', '--no-warnings',
      '--max-filesize', '45m',
      '--extractor-args', 'youtube:player_client=android,web',
    ], { timeout: DL_TIMEOUT }, (err) => {""",
  "music.js (ytDownload: android client)", "player_client=android,web',\n    ], { timeout: DL_TIMEOUT }")

print('')
print('✅ خلصت')
