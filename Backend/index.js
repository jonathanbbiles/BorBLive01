require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { router: healthRouter } = require('./routes/health');
const { router: ordersRouter } = require('./routes/orders');
const { router: positionsRouter } = require('./routes/positions');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', healthRouter);
app.use('/api', ordersRouter);
app.use('/api', positionsRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[backend] listening on :${port}`));
