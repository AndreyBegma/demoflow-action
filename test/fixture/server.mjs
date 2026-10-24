// The self-test's app (spec Decision 8): two static pages on $PORT, no
// dependency. `demoflow run` starts it from `devCommand` and stops it after.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3790);

const page = (title, body) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 48px; background: #f6f7fb; color: #1d1f2b; }
      nav a { margin-right: 16px; }
      table { border-collapse: collapse; margin-top: 24px; }
      td, th { border: 1px solid #ccd; padding: 8px 16px; text-align: left; }
    </style>
  </head>
  <body>
    <nav><a href="/">Home</a><a href="/customers">Customers</a></nav>
    ${body}
  </body>
</html>
`;

const pages = {
  '/': page(
    'Fixture',
    '<h1>DemoFlow fixture</h1><p>A tiny app for the action self-test.</p>',
  ),
  '/customers': page(
    'Customers',
    `<h1>Customers</h1>
    <table>
      <tr><th>Name</th><th>City</th></tr>
      <tr><td>Ann Lee</td><td>Lisbon</td></tr>
      <tr><td>Bo Chen</td><td>Oslo</td></tr>
    </table>`,
  ),
};

createServer((request, response) => {
  const html = pages[new URL(request.url, 'http://localhost').pathname];
  response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html ?? page('Not found', '<h1>Not found</h1>'));
}).listen(port, () => {
  console.log(`fixture listening on http://localhost:${port}/`);
});
