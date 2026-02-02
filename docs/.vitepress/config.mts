import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Agent Server',
  description: 'REST API server infrastructure for AI agents - supports agent-sdk and custom implementations',
  base: '/agent-server/',
  ignoreDeadLinks: true,
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/server' },
      { text: 'Examples', link: '/examples/' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Core Concepts', link: '/guide/core-concepts' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Integration',
          items: [
            { text: 'Express.js', link: '/guide/express' },
            { text: 'Next.js', link: '/guide/nextjs' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Storage Providers', link: '/guide/storage' },
            { text: 'Authentication', link: '/guide/authentication' },
            { text: 'File Management', link: '/guide/file-management' },
            { text: 'Streaming', link: '/guide/streaming' },
            { text: 'Swagger UI', link: '/guide/swagger' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Custom Agents', link: '/guide/custom-agents' },
            { text: 'Custom Storage', link: '/guide/custom-storage' },
            { text: 'Error Handling', link: '/guide/error-handling' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Server', link: '/api/server' },
            { text: 'Types', link: '/api/types' },
            { text: 'Adapters', link: '/api/adapters' },
            { text: 'Storage Providers', link: '/api/storage' },
            { text: 'Auth Providers', link: '/api/auth' },
            { text: 'REST Endpoints', link: '/api/endpoints' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Overview', link: '/examples/' },
            { text: 'Express Basic', link: '/examples/express-basic' },
            { text: 'Express with PostgreSQL', link: '/examples/express-postgres' },
            { text: 'Next.js App Router', link: '/examples/nextjs-app' },
            { text: 'Custom Agent', link: '/examples/custom-agent' },
            { text: 'JWT Authentication', link: '/examples/jwt-auth' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Cognipeer/agent-server' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 CognipeerAI',
    },
    search: {
      provider: 'local',
    },
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/agent-server/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'Agent Server Documentation' }],
  ],
});
