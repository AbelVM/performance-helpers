import { onScopeDispose, ref } from 'vue';
import { PowerObserver } from 'performance-helpers/powerObserver';

export function usePowerObserver(observer) {
  const value = ref(observer.value);
  const unsubscribe = observer.subscribe((next) => {
    value.value = next;
  });

  onScopeDispose(unsubscribe);
  return value;
}

// Example ownership at a feature boundary:
export function useActiveRequests() {
  const observer = new PowerObserver(0, { distinct: true });
  const value = usePowerObserver(observer);

  onScopeDispose(() => observer.dispose());
  return { value, observer };
}
