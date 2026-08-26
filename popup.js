const PREFIX = 'glv:pr:';

function count(rec) {
  return Object.values(rec.lines || {}).reduce((n, a) => n + a.length, 0);
}

function render() {
  chrome.storage.local.get(null, (all) => {
    const list = document.getElementById('list');
    list.innerHTML = '';
    const keys = Object.keys(all)
      .filter((k) => k.startsWith(PREFIX))
      .sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0));

    if (!keys.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '記録はまだありません。';
      list.appendChild(li);
      return;
    }

    for (const key of keys) {
      const rec = all[key];
      const name = key.slice(PREFIX.length); // owner/repo#123
      const [repo, num] = name.split('#');
      const li = document.createElement('li');

      const wrap = document.createElement('div');
      wrap.className = 'pr';
      const a = document.createElement('a');
      a.href = 'https://github.com/' + repo + '/pull/' + num + '/files';
      a.target = '_blank';
      a.textContent = name;
      const c = document.createElement('div');
      c.className = 'cnt';
      c.textContent = count(rec) + ' 行 確認済';
      wrap.append(a, c);

      const btn = document.createElement('button');
      btn.textContent = '削除';
      btn.addEventListener('click', () => chrome.storage.local.remove(key, render));

      li.append(wrap, btn);
      list.appendChild(li);
    }
  });
}

document.getElementById('clear').addEventListener('click', () => {
  if (!confirm('すべての PR の記録を削除します。よろしいですか？')) return;
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
    chrome.storage.local.remove(keys, render);
  });
});

render();
