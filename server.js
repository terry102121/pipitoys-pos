const express = require('express');
const { Pool } = require('pg'); // 🌟 改用 PostgreSQL 雲端套件
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔒 您的私人環境通關密碼
const PRIVATE_ACCESS_PASSWORD = "Pipi25508846";

// ☁️ 連接您專屬的 Neon 雲端資料庫
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_A6GnWyp1XilZ@ep-small-violet-ao6fndg5-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
});

// 🌟 自動初始化雲端資料庫 (建立資料表與預設帳號)
const initCloudDB = async () => {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS employees (emp_id VARCHAR(10) PRIMARY KEY, password VARCHAR(50) NOT NULL)`);
        await client.query(`CREATE TABLE IF NOT EXISTS products (barcode VARCHAR(50) PRIMARY KEY, custom_code VARCHAR(50), name VARCHAR(100) NOT NULL, type VARCHAR(50), price REAL NOT NULL, avg_cost REAL DEFAULT 0, stock INTEGER DEFAULT 0)`);
        await client.query(`CREATE TABLE IF NOT EXISTS sales (sale_id SERIAL PRIMARY KEY, sale_date VARCHAR(20) NOT NULL, emp_id VARCHAR(10), payment_method VARCHAR(50) NOT NULL, total_qty INTEGER NOT NULL, total_amount REAL NOT NULL, sales_channel VARCHAR(50))`);
        await client.query(`CREATE TABLE IF NOT EXISTS sale_items (id SERIAL PRIMARY KEY, sale_id INTEGER NOT NULL, barcode VARCHAR(50) NOT NULL, price REAL NOT NULL, quantity INTEGER NOT NULL, subtotal REAL NOT NULL, note TEXT)`);
        await client.query(`CREATE TABLE IF NOT EXISTS purchases (purchase_id SERIAL PRIMARY KEY, barcode VARCHAR(50) NOT NULL, purchase_date VARCHAR(20) NOT NULL, quantity INTEGER NOT NULL, cost REAL NOT NULL, note TEXT)`);
        await client.query(`CREATE TABLE IF NOT EXISTS peer_adjustments (adj_id SERIAL PRIMARY KEY, barcode VARCHAR(50) NOT NULL, peer_code VARCHAR(50) NOT NULL, peer_name VARCHAR(100) NOT NULL, quantity INTEGER NOT NULL, type VARCHAR(20) NOT NULL, adj_date VARCHAR(20) NOT NULL, note TEXT)`);
        
        // 自動寫入預設公共帳號
        await client.query(`INSERT INTO employees (emp_id, password) VALUES ('0000', '000000') ON CONFLICT DO NOTHING`);
        console.log("✅ 雲端資料庫連線成功！資料表與預設帳號 (0000) 已準備就緒！");
    } catch (err) {
        console.error("❌ 雲端資料庫初始化失敗:", err);
    } finally {
        client.release();
    }
};
initCloudDB();

app.use(express.static(path.join(__dirname, 'public')));

// 1. 驗證通關密碼
app.post('/api/verify-site-access', (req, res) => {
    if (req.body.password === PRIVATE_ACCESS_PASSWORD) return res.json({ success: true, message: "網站通關成功" });
    return res.status(401).json({ success: false, message: "通關密碼錯誤，拒絕連線" });
});

// 2. 驗證員工登入
app.post('/api/login', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM employees WHERE emp_id = $1 AND password = $2`, [req.body.emp_id, req.body.password]);
        if (rows.length > 0) res.json({ success: true, employee: { emp_id: rows[0].emp_id } });
        else res.status(401).json({ success: false, message: "員工帳號或密碼錯誤！" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 3. 搜尋商品
app.get('/api/product/search', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM products WHERE barcode = $1 OR custom_code = $1`, [req.query.code]);
        if (rows.length > 0) res.json({ success: true, product: rows[0] });
        else res.json({ success: false, message: "找不到該商品，請至進貨/建檔畫面新增" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 4. 進貨建檔 & 更新
app.post('/api/product/upsert', async (req, res) => {
    const { barcode, custom_code, name, type, price, stock, cost } = req.body;
    const qtyIn = parseInt(stock || 0); const costIn = parseFloat(cost || 0);
    const dateStr = new Date().toISOString().split('T')[0];
    try {
        const { rows } = await pool.query(`SELECT * FROM products WHERE barcode = $1`, [barcode]);
        if (rows.length > 0) {
            let oldStock = rows[0].stock; let oldCost = rows[0].avg_cost;
            let newStock = oldStock + qtyIn;
            let newAvgCost = (qtyIn > 0 && costIn > 0) ? ((oldStock * oldCost) + (qtyIn * costIn)) / newStock : oldCost;
            await pool.query(`UPDATE products SET custom_code = $1, name = $2, type = $3, price = $4, avg_cost = $5, stock = $6 WHERE barcode = $7`, [custom_code || rows[0].custom_code, name || rows[0].name, type || rows[0].type, price || rows[0].price, newAvgCost, newStock, barcode]);
            if (qtyIn > 0) await pool.query(`INSERT INTO purchases (barcode, purchase_date, quantity, cost, note) VALUES ($1, $2, $3, $4, $5)`, [barcode, dateStr, qtyIn, costIn, '進貨']);
            res.json({ success: true, message: "商品更新成功！" });
        } else {
            await pool.query(`INSERT INTO products (barcode, custom_code, name, type, price, avg_cost, stock) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [barcode, custom_code, name, type, price, costIn, qtyIn]);
            if (qtyIn > 0) await pool.query(`INSERT INTO purchases (barcode, purchase_date, quantity, cost, note) VALUES ($1, $2, $3, $4, $5)`, [barcode, dateStr, qtyIn, costIn, '首建']);
            res.json({ success: true, message: "新商品建檔成功！" });
        }
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 5. 結帳存檔 (交易事務)
app.post('/api/sales/checkout', async (req, res) => {
    const { emp_id, payment_method, total_qty, total_amount, sales_channel, items } = req.body;
    const dateStr = new Date().toISOString().split('T')[0];
    if (!items || items.length === 0) return res.status(400).json({ success: false, message: "明細不能為空" });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const saleResult = await client.query(`INSERT INTO sales (sale_date, emp_id, payment_method, total_qty, total_amount, sales_channel) VALUES ($1, $2, $3, $4, $5, $6) RETURNING sale_id`, [dateStr, emp_id, payment_method, total_qty, total_amount, sales_channel || '店面']);
        const saleId = saleResult.rows[0].sale_id;
        for (let item of items) {
            await client.query(`INSERT INTO sale_items (sale_id, barcode, price, quantity, subtotal, note) VALUES ($1, $2, $3, $4, $5, $6)`, [saleId, item.barcode, item.price, item.qty, item.subtotal, item.note || '']);
            await client.query(`UPDATE products SET stock = stock - $1 WHERE barcode = $2`, [item.qty, item.barcode]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: "🎉 結帳成功，已同步至雲端！", sale_id: saleId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// 6. 歷史導航
app.get('/api/sales/navigate', async (req, res) => {
    const { current_id, direction } = req.query;
    try {
        let saleRow;
        if (direction === 'first') saleRow = await pool.query(`SELECT * FROM sales ORDER BY sale_id ASC LIMIT 1`);
        else if (direction === 'last') saleRow = await pool.query(`SELECT * FROM sales ORDER BY sale_id DESC LIMIT 1`);
        else if (direction === 'prev') saleRow = await pool.query(`SELECT * FROM sales WHERE sale_id < $1 ORDER BY sale_id DESC LIMIT 1`, [current_id || 0]);
        else if (direction === 'next') saleRow = await pool.query(`SELECT * FROM sales WHERE sale_id > $1 ORDER BY sale_id ASC LIMIT 1`, [current_id || 0]);
        else saleRow = await pool.query(`SELECT * FROM sales ORDER BY sale_id DESC LIMIT 1`);

        if (saleRow.rows.length === 0) return res.json({ success: false, message: "已無更多單據" });
        const s = saleRow.rows[0];
        const items = await pool.query(`SELECT si.*, p.name FROM sale_items si JOIN products p ON si.barcode = p.barcode WHERE si.sale_id = $1`, [s.sale_id]);
        res.json({ success: true, sale: s, items: items.rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 7. 同行調貨
app.post('/api/peer/adjustment', async (req, res) => {
    const { barcode, peer_code, peer_name, quantity, type } = req.body;
    const dateStr = new Date().toISOString().split('T')[0];
    const qtyChange = parseInt(quantity || 0);
    const stockMultiplier = (type === '調入') ? 1 : -1;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`UPDATE products SET stock = stock + $1 WHERE barcode = $2`, [qtyChange * stockMultiplier, barcode]);
        await client.query(`INSERT INTO peer_adjustments (barcode, peer_code, peer_name, quantity, type, adj_date, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [barcode, peer_code, peer_name, qtyChange, type, dateStr, '']);
        await client.query('COMMIT');
        res.json({ success: true, message: "🤝 同行調貨成功，庫存已雲端同步！" });
    } catch (err) {
        await client.query('ROLLBACK'); res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// 8. 報表
app.get('/api/reports/summary', async (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
        const { rows } = await pool.query(`SELECT * FROM sales WHERE sale_date = $1`, [date]);
        let tq = 0, tr = 0, pb = { "現金": 0, "信用卡": 0, "LINE Pay": 0 };
        rows.forEach(r => { tq += r.total_qty; tr += r.total_amount; if(pb[r.payment_method] !== undefined) pb[r.payment_method] += r.total_amount; });
        res.json({ success: true, period: date, total_orders: rows.length, total_qty: tq, total_revenue: tr, payment_breakdown: pb });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 9. 新增帳號
app.post('/api/employees/add', async (req, res) => {
    try {
        await pool.query(`INSERT INTO employees (emp_id, password) VALUES ($1, $2)`, [req.body.emp_id, req.body.password]);
        res.json({ success: true, message: `🎉 成功新增帳號：${req.body.emp_id}` });
    } catch (err) {
        if (err.code === '23505') res.status(400).json({ success: false, message: "❌ 帳號已存在！" });
        else res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` 🚀 雲端升級版：PIPI TOYS 伺服器啟動！`);
    console.log(` 💻 本地測試網址: http://localhost:${PORT}`);
    console.log(`===================================================`);
});