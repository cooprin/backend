const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('CRM Backend is running');
});

app.listen(PORT, () => {
    console.log(`Backend server is running on port ${PORT}`);
});
