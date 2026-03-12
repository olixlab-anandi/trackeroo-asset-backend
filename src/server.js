import app from './app.js';
import { ENV } from './env.js';

// app.listen(ENV.PORT, () => {
//   console.log(`API running → http://localhost:${ENV.PORT}`);
// });

app.listen(ENV.PORT, '0.0.0.0', () => {
  console.log(`API running → http://localhost:${ENV.PORT}`);
});