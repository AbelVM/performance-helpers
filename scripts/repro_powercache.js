import { PowerCache } from '../src/helpers/powerCache.js';

(async () => {
  const c = new PowerCache({ defaultTTL: 1, maxEntries: 10 });
  c.set('a', 1, { ttl: 1 });
  await new Promise((r) => setTimeout(r, 5));
  console.log('peek:', c.peek('a'));
  console.log('map has a before has(ignoreExpiry):', c.map.has('a'));
  console.log('has(ignoreExpiry):', c.has('a', { ignoreExpiry: true }));
  console.log('map has a after has(ignoreExpiry):', c.map.has('a'));
  console.log('has():', c.has('a'));
  console.log('delete:', c.delete('a'));
  console.log('map has a after delete:', c.map.has('a'));
})();
