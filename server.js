const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PRIVATE_ACCESS_PASSWORD = "Pipi25508846";

// ☁️ 您的 Neon 雲端資料庫連線
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_A6GnWyp1XilZ@ep-small-violet-ao6fndg5-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
});

const initCloudDB = async () => {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS employees (emp_id VARCHAR(10) PRIMARY KEY, password VARCHAR(50) NOT NULL)`);
        await client.query(`CREATE TABLE IF NOT EXISTS products (barcode VARCHAR(50) PRIMARY KEY, custom_code VARCHAR(50), name VARCHAR(100) NOT NULL, type VARCHAR(50), price REAL NOT NULL, avg_cost REAL DEFAULT 0, stock INTEGER DEFAULT 0)`);
        // 新增 cost 欄位以計算利潤
        await client.query(`CREATE TABLE IF NOT EXISTS sale_items (id SERIAL PRIMARY KEY, sale_id INTEGER NOT NULL, barcode VARCHAR(50) NOT NULL, price REAL NOT NULL, cost REAL DEFAULT 0, quantity INTEGER NOT NULL, subtotal REAL NOT NULL, note TEXT)`);
        await client.query(`CREATE TABLE IF NOT EXISTS sales (sale_id SERIAL PRIMARY KEY, sale_date VARCHAR(20) NOT NULL, emp_id VARCHAR(10), payment_method VARCHAR(50) NOT NULL, total_qty INTEGER NOT NULL, total_amount REAL NOT NULL, total_cost REAL DEFAULT 0, sales_channel VARCHAR(50))`);
        await client.query(`CREATE TABLE IF NOT EXISTS purchases (purchase_id SERIAL PRIMARY KEY, barcode VARCHAR(50) NOT NULL, purchase_date VARCHAR(20) NOT NULL, quantity INTEGER NOT NULL, cost REAL NOT NULL, note TEXT)`);
        // 新增 peers 同行資料庫
        await client.query(`CREATE TABLE IF NOT EXISTS peers (peer_code VARCHAR(50) PRIMARY KEY, peer_name VARCHAR(100) NOT NULL)`);
        await client.query(`CREATE TABLE IF NOT EXISTS peer_adjustments (adj_id SERIAL PRIMARY KEY, barcode VARCHAR(50) NOT NULL, peer_code VARCHAR(50) NOT NULL, quantity INTEGER NOT NULL, type VARCHAR(20) NOT NULL, adj_date VARCHAR(20) NOT NULL)`);
        
        await client.query(`INSERT INTO employees (emp_id, password) VALUES ('0000', '000000') ON CONFLICT DO NOTHING`);
        console.log("✅ 終極版雲端資料庫已準備就緒！");
    } catch (err) { console.error("❌ 初始化失敗:", err); } finally { client.release(); }
};
initCloudDB();

app.use(express.static(path.join(__dirname, 'public')));

// 1. 通關與登入
app.post('/api/verify-site-access', (req, res) => {
    if (req.body.password === PRIVATE_ACCESS_PASSWORD) return res.json({ success: true });
    return res.status(401).json({ success: false, message: "通關密碼錯誤" });
});
app.post('/api/login', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM employees WHERE emp_id = $1 AND password = $2`, [req.body.emp_id, req.body.password]);
        if (rows.length > 0) res.json({ success: true, employee: { emp_id: rows[0].emp_id } });
        else res.status(401).json({ success: false, message: "帳號或密碼錯誤！" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 2. 搜尋商品
app.get('/api/product/search', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM products WHERE barcode = $1 OR custom_code = $1`, [req.query.code]);
        if (rows.length > 0) res.json({ success: true, product: rows[0] });
        else res.json({ success: false, message: "找不到商品" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 3. 進貨 (打條碼、數量、進價)
app.post('/api/product/receive', async (req, res) => {
    const { barcode, quantity, cost, price } = req.body;
    const qtyIn = parseInt(quantity || 0); const costIn = parseFloat(cost || 0); const newPrice = parseFloat(price || 0);
    const dateStr = new Date().toISOString().split('T')[0];
    try {
        const { rows } = await pool.query(`SELECT * FROM products WHERE barcode = $1`, [barcode]);
        if (rows.length === 0) return res.json({ success: false, message: "商品未建檔，請先至建檔區新增" });
        
        let oldStock = rows[0].stock; let oldCost = rows[0].avg_cost;
        let newStock = oldStock + qtyIn;
        let newAvgCost = (qtyIn > 0 && costIn > 0) ? ((oldStock * oldCost) + (qtyIn * costIn)) / newStock : oldCost;
        
        await pool.query(`UPDATE products SET avg_cost = $1, stock = $2, price = $3 WHERE barcode = $4`, [newAvgCost, newStock, newPrice || rows[0].price, barcode]);
        await pool.query(`INSERT INTO purchases (barcode, purchase_date, quantity, cost, note) VALUES ($1, $2, $3, $4, $5)`, [barcode, dateStr, qtyIn, costIn, '一般進貨']);
        res.json({ success: true, message: "進貨成功！庫存與成本已更新" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 4. 商品建檔 (單筆或批次 Excel)
app.post('/api/product/create', async (req, res) => {
    const products = req.body.products; // 預期為陣列
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let p of products) {
            await client.query(`INSERT INTO products (barcode, custom_code, name, type, price, avg_cost, stock) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (barcode) DO UPDATE SET custom_code = $2, name = $3, price = $5`, 
            [p.barcode, p.custom_code || '', p.name, p.type || '一般', p.price || 0, p.cost || 0, 0]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: `成功建檔/更新 ${products.length} 筆商品！` });
    } catch (err) {
        await client.query('ROLLBACK'); res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// 5. 結帳 (無限排，加入成本紀錄以算利潤)
app.post('/api/sales/checkout', async (req, res) => {
    const { emp_id, payment_method, items } = req.body;
    const dateStr = new Date().toISOString().split('T')[0];
    if (!items || items.length === 0) return res.status(400).json({ success: false, message: "明細不能為空" });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let total_qty = 0, total_amount = 0, total_cost = 0;
        
        // 計算總額與抓取成本
        for (let item of items) {
            const pRes = await client.query(`SELECT avg_cost FROM products WHERE barcode = $1`, [item.barcode]);
            const unitCost = pRes.rows.length > 0 ? pRes.rows[0].avg_cost : 0;
            item.cost = unitCost;
            total_qty += item.qty;
            total_amount += item.subtotal;
            total_cost += (unitCost * item.qty);
        }

        const saleResult = await client.query(`INSERT INTO sales (sale_date, emp_id, payment_method, total_qty, total_amount, total_cost, sales_channel) VALUES ($1, $2, $3, $4, $5, $6, '店面') RETURNING sale_id`, [dateStr, emp_id, payment_method, total_qty, total_amount, total_cost]);
        const saleId = saleResult.rows[0].sale_id;
        
        for (let item of items) {
            await client.query(`INSERT INTO sale_items (sale_id, barcode, price, cost, quantity, subtotal, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [saleId, item.barcode, item.price, item.cost, item.qty, item.subtotal, '']);
            await client.query(`UPDATE products SET stock = stock - $1 WHERE barcode = $2`, [item.qty, item.barcode]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: "結帳成功！", sale_id: saleId });
    } catch (err) {
        await client.query('ROLLBACK'); res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// 6. 同行管理與調貨
app.post('/api/peers/add', async (req, res) => {
    try {
        await pool.query(`INSERT INTO peers (peer_code, peer_name) VALUES ($1, $2) ON CONFLICT (peer_code) DO UPDATE SET peer_name = $2`, [req.body.peer_code, req.body.peer_name]);
        res.json({ success: true, message: "同行資料更新成功" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/peers/list', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM peers ORDER BY peer_code ASC`);
        res.json({ success: true, peers: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/peer/adjustment', async (req, res) => {
    const { peer_code, items, type } = req.body; // items 為陣列
    const dateStr = new Date().toISOString().split('T')[0];
    const stockMultiplier = (type === '調入') ? 1 : -1;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for(let item of items) {
            await client.query(`UPDATE products SET stock = stock + $1 WHERE barcode = $2`, [item.qty * stockMultiplier, item.barcode]);
            await client.query(`INSERT INTO peer_adjustments (barcode, peer_code, quantity, type, adj_date) VALUES ($1, $2, $3, $4, $5)`, [item.barcode, peer_code, item.qty, type, dateStr]);
        }
        await client.query('COMMIT');
        res.json({ success: true, message: "同行調貨完成！" });
    } catch (err) {
        await client.query('ROLLBACK'); res.status(500).json({ success: false, error: err.message });
    } finally { client.release(); }
});

// 7. 報表 (包含毛利)
app.get('/api/reports/summary', async (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    try {
        const { rows } = await pool.query(`SELECT * FROM sales WHERE sale_date = $1`, [date]);
        let tq = 0, tr = 0, tc = 0;
        rows.forEach(r => { tq += r.total_qty; tr += r.total_amount; tc += (r.total_cost || 0); });
        res.json({ success: true, total_orders: rows.length, total_qty: tq, total_revenue: tr, total_profit: tr - tc });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, () => console.log(`🚀 終極版伺服器啟動於 ${PORT}`));
