const fs = require('fs');
const path = require('path');

function walk(dir, list = []) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    let st;
    try {
      st = fs.statSync(p);
    } catch (err) {
      continue;
    }
    if (st.isDirectory()) walk(p, list);
    else if (p.endsWith('.js')) list.push(p);
  }
  return list;
}

const files = walk('src');

const propRegex = /([A-Za-z_$][\w$\.]*)\s*&&\s*\1\./g;
const callRegex = /([A-Za-z_$][\w$\.]*)\s*&&\s*\1\s*\(/g;
const typeofRegex = /([A-Za-z_$][\w$\.]*)\s*&&\s*typeof\s+\1\./g;

files.forEach(f => {
  try {
    let s = fs.readFileSync(f, 'utf8');
    let t = s.replace(propRegex, '$1?.').replace(callRegex, '$1?.(').replace(typeofRegex, 'typeof $1?.');
    if (t !== s) {
      fs.writeFileSync(f, t, 'utf8');
      console.log('patched', f);
    }
  } catch (e) {
    console.error('error processing', f, e && e.message);
  }
});
