import createFetchMock from 'vitest-fetch-mock';
import { vi, beforeEach, afterEach } from 'vitest';

const fetchMocker = createFetchMock(vi);

beforeEach(() => {
  fetchMocker.enableMocks();
  fetchMocker.resetMocks();
});

afterEach(() => {
  fetchMocker.disableMocks();
});

export { fetchMocker };
