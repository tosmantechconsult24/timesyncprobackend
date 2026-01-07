const express = require('express');
const app = express();
app.get('/health', (req,res)=> res.json({status:'ok'}));
const s = app.listen(4000, ()=> console.log('test server listening 4000'));
setTimeout(()=>{console.log('still alive');}, 5000);
