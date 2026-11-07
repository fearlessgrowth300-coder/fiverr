import app from '../app.js';
app.listen(Number(process.env.PORT||8787),process.env.HOST||'127.0.0.1',()=>console.error('Gig Studio: http://127.0.0.1:'+(process.env.PORT||8787)));
