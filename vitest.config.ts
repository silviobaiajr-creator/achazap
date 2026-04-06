import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,         // habilita describe/it/expect sem imports explícitos
        environment: 'node',
        include: ['src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/vitest.d.ts'],
        },
    },
});
