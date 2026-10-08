import { PowerObserver } from 'performance-helpers/powerObserver';

// This is the framework-neutral boundary used by the snippets in frameworks/.
// A component subscribes to the observer; the owner disposes it on teardown.
const activeRequests = new PowerObserver(0, { async: false, distinct: true });
const values = [];
const unsubscribe = activeRequests.subscribe((value) => values.push(value));

activeRequests.value = 1;
activeRequests.value = 0;
unsubscribe();
activeRequests.dispose();

if (values.join(',') !== '1,0') {
  throw new Error(`unexpected observer values: ${values.join(',')}`);
}

console.log('framework adapter lifecycle: subscribe -> update -> dispose');
console.log('OK');
