import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Agent Server',
  description: 'REST API server infrastructure for AI agents with storage, auth, streaming, and framework adapters.',
  base: '/agent-server/',
  ignoreDeadLinks: true,
  appearance: false,

  themeConfig: {
    logo: '/AgentServer.svg',
    siteTitle: 'Agent Server',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Architecture', link: '/guide/architecture' },
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
            { text: 'Custom Adapters', link: '/guide/custom-adapters' },
            { text: 'Client Integration', link: '/guide/client-integration' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Storage Providers', link: '/guide/storage' },
            { text: 'Authentication', link: '/guide/authentication' },
            { text: 'Conversations & Messages', link: '/guide/conversations-messages' },
            { text: 'File Management', link: '/guide/file-management' },
            { text: 'Streaming', link: '/guide/streaming' },
            { text: 'Swagger UI', link: '/guide/swagger' },
            { text: 'AI Providers', link: '/guide/ai-providers' },
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
      message: 'Agent Server is part of the Cognipeer platform.',
      copyright: 'Copyright © 2026 Cognipeer',
    },
    search: {
      provider: 'local',
    },
  },
  head: [
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@400;500;600;700;800&display=swap' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/agent-server/AgentServer.svg' }],
    ['meta', { name: 'theme-color', content: '#00b5a5' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'Agent Server Documentation' }],
  ],
});
