import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/** 功能：在每个测试后卸载 React 树；入参：无；返回值：无；防止跨测试残留 DOM 造成重复元素和状态污染。 */
afterEach(() => {
  cleanup();
});
