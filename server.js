const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const dataPath = path.join(__dirname, 'data.json');
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

let useFirestore = false;
let db = null;
let serviceAccount = null;

if (firebaseServiceAccount) {
    try {
        serviceAccount = JSON.parse(firebaseServiceAccount);
    } catch (err) {
        console.error('Invalid FIREBASE_SERVICE_ACCOUNT JSON:', err);
    }
} else if (fs.existsSync(serviceAccountPath)) {
    try {
        serviceAccount = require(serviceAccountPath);
    } catch (err) {
        console.error('Не удалось загрузить serviceAccountKey.json:', err);
    }
}

if (serviceAccount) {
    try {
        const admin = require('firebase-admin');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        db = admin.firestore();
        useFirestore = true;
        console.log('Firestore enabled — using Firebase as storage');
    } catch (err) {
        console.error('Не удалось инициализировать Firebase Admin SDK:', err);
        useFirestore = false;
    }
}

const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) {
    fs.mkdirSync(uploadPath, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPath),
    filename: (req, file, cb) => {
        const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-_]/g, '_')}`;
        cb(null, safeName);
    },
});

const upload = multer({ storage });

function loadData() {
    try {
        const raw = fs.readFileSync(dataPath);
        return JSON.parse(raw);
    } catch (err) {
        return { posts: {}, users: [], sessions: {} };
    }
}

function saveData(data) {
    if (!data.posts) data.posts = {};
    if (!data.users) data.users = [];
    if (!data.sessions) data.sessions = {};
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

async function loadBoard(board) {
    if (useFirestore && db) {
        const doc = await db.collection('boards').doc(board).get();
        if (!doc.exists) return [];
        return doc.data().posts || [];
    } else {
        const data = loadData();
        return data.posts[board] || [];
    }
}

async function saveBoard(board, posts) {
    if (useFirestore && db) {
        await db.collection('boards').doc(board).set({ posts });
    } else {
        const data = loadData();
        if (!data.posts) data.posts = {};
        data.posts[board] = posts;
        saveData(data);
    }
}

// отдаём статические файлы (index.html и прочие) из корня
app.use(express.static(__dirname));

app.get('/posts/:board', async (req, res) => {
    const board = req.params.board;
    try {
        const posts = await loadBoard(board);
        res.json(posts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/posts/:board', upload.single('media'), async (req, res) => {
    const board = req.params.board;
    const { author, email, content } = req.body;

    const hasContent = content && content.trim();
    const hasMedia = !!req.file;
    if (!hasContent && !hasMedia) {
        return res.status(400).json({ error: 'Пост должен содержать текст или медиа' });
    }

    try {
        const posts = await loadBoard(board);
        const newPost = {
            id: (posts.length ? Math.max(...posts.map(p => p.id)) : 0) + 1,
            author: author || 'Аноним',
            email: email || '',
            content: content || '',
            time: new Date().toLocaleString('ru-RU').replace(',', ''),
            comments: [],
        };

        if (req.file) {
            newPost.media = {
                url: `/uploads/${req.file.filename}`,
                originalName: req.file.originalname,
                mimeType: req.file.mimetype,
                size: req.file.size,
            };
        }

        posts.unshift(newPost);
        await saveBoard(board, posts);

        res.json(newPost);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка при сохранении поста' });
    }
});

// получить комментарии к посту
app.get('/posts/:board/:postId/comments', async (req, res) => {
    const { board, postId } = req.params;
    try {
        const posts = await loadBoard(board);
        const post = posts.find(p => p.id === parseInt(postId));

        if (!post) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        res.json(post.comments || []);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// добавить комментарий к посту
app.post('/posts/:board/:postId/comments', async (req, res) => {
    const { board, postId } = req.params;
    const { author, email, content } = req.body;

    if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Пустой контент' });
    }

    try {
        const posts = await loadBoard(board);
        const postIndex = posts.findIndex(p => p.id === parseInt(postId));

        if (postIndex === -1) {
            return res.status(404).json({ error: 'Пост не найден' });
        }

        const post = posts[postIndex];
        if (!post.comments) post.comments = [];

        const newComment = {
            id: post.comments.length + 1,
            author: author || 'Аноним',
            email: email || '',
            content: content,
            time: new Date().toLocaleString('ru-RU').replace(',', ''),
        };

        post.comments.push(newComment);
        posts[postIndex] = post;
        await saveBoard(board, posts);

        res.json(newComment);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка при сохранении комментария' });
    }
});

// ========== AUTHENTICATION ENDPOINTS ==========

// Регистрация
app.post('/auth/register', (req, res) => {
    const { username, password, email } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
    }

    if (username.length < 3 || password.length < 4) {
        return res.status(400).json({ error: 'Имя не менее 3 символов, пароль не менее 4' });
    }

    try {
        const data = loadData();
        if (!data.users) data.users = [];
        if (!data.sessions) data.sessions = {};

        // Проверяем, не существует ли пользователь
        if (data.users.find(u => u.username === username)) {
            return res.status(409).json({ error: 'Пользователь с таким именем уже существует' });
        }

        const newUser = {
            id: (data.users.length ? Math.max(...data.users.map(u => u.id)) : 0) + 1,
            username: username,
            password: password, // В реальном приложении используйте bcryptjs
            email: email || '',
            createdAt: new Date().toLocaleString('ru-RU'),
        };

        data.users.push(newUser);

        // Создаём сессию
        const sessionId = Math.random().toString(36).substring(2, 15);
        data.sessions[sessionId] = { username, createdAt: Date.now() };

        saveData(data);

        res.json({
            success: true,
            sessionId,
            user: { id: newUser.id, username: newUser.username, email: newUser.email },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка при регистрации' });
    }
});

// Вход
app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
    }

    try {
        const data = loadData();
        if (!data.users) data.users = [];
        if (!data.sessions) data.sessions = {};

        const user = data.users.find(u => u.username === username && u.password === password);

        if (!user) {
            return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
        }

        // Создаём сессию
        const sessionId = Math.random().toString(36).substring(2, 15);
        data.sessions[sessionId] = { username, createdAt: Date.now() };
        saveData(data);

        res.json({
            success: true,
            sessionId,
            user: { id: user.id, username: user.username, email: user.email },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка при входе' });
    }
});

// Получить текущего пользователя
app.get('/auth/user', (req, res) => {
    const sessionId = req.headers['x-session-id'];

    if (!sessionId) {
        return res.status(401).json({ error: 'Не авторизован' });
    }

    try {
        const data = loadData();
        if (!data.users) data.users = [];
        if (!data.sessions || !data.sessions[sessionId]) {
            return res.status(401).json({ error: 'Не авторизован' });
        }

        const user = data.users.find(u => u.username === data.sessions[sessionId].username);

        if (!user) {
            return res.status(401).json({ error: 'Пользователь не найден' });
        }

        res.json({
            user: { id: user.id, username: user.username, email: user.email },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Выход
app.post('/auth/logout', (req, res) => {
    const sessionId = req.headers['x-session-id'];

    try {
        if (sessionId) {
            const data = loadData();
            if (data.sessions && data.sessions[sessionId]) {
                delete data.sessions[sessionId];
                saveData(data);
            }
        }
    } catch (err) {
        console.error('Ошибка при выходе:', err);
    }

    res.json({ success: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is listening on http://localhost:${port}`);
});
