import express from 'express';
import multer from 'multer';
import { dryRunFromBuffer, importFromBuffer } from '../services/importService.js';

const router = express.Router();
const upload = multer();

router.get('/_ok', (req, res) => res.json({ ok: true, scope: 'imports' }));

// Dry run: always requires a file upload
router.post('/assets/dry-run', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    const mappingJson = req.body.mapping_json
      ? JSON.parse(req.body.mapping_json)
      : null;

    const preview = await dryRunFromBuffer(
      req.file.buffer,
      req.file.originalname,
      mappingJson
    );

    return res.json({ preview });
  } catch (e) {
    console.error('dry-run error', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

// Confirm: always requires a file upload
router.post('/assets/confirm', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

     const userEmail = req.body.user_email || null;

     //console.log('=== Users Email ===', userEmail);

    const mappingJson = req.body.mapping_json
      ? JSON.parse(req.body.mapping_json)
      : null;

    const summary = await importFromBuffer(
      req.file.buffer,
      req.file.originalname,
      mappingJson,
      userEmail
    );

    return res.json({ summary });
  } catch (e) {
    console.error('confirm import error', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
});

export default router;
