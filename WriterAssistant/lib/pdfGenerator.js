'use strict';

const PDFDocument = require('pdfkit');

const COLORS = {
  bg: '#0f0f13',
  accent: '#6c63ff',
  text: '#e8e8f0',
  muted: '#9090a8',
  divider: '#2e2e42'
};

function generatePDF(storyData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 60,
      size: 'LETTER',
      info: { Title: 'Story Structure Document', Creator: 'Writer Assistant' }
    });

    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 120; // account for margins

    // ─── Helper functions ───────────────────────────────────────────

    function heading1(text) {
      doc.fontSize(26).fillColor(COLORS.accent).font('Helvetica-Bold').text(text, { align: 'center' });
      doc.moveDown(0.5);
    }

    function heading2(text) {
      doc.fontSize(16).fillColor(COLORS.accent).font('Helvetica-Bold').text(text);
      doc.moveDown(0.3);
      doc.moveTo(60, doc.y).lineTo(60 + pageWidth, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
      doc.moveDown(0.5);
    }

    function heading3(text) {
      doc.fontSize(13).fillColor(COLORS.accent).font('Helvetica-Bold').text(text);
      doc.moveDown(0.2);
    }

    function body(text) {
      if (!text || text.trim() === '') return;
      doc.fontSize(11).fillColor(COLORS.text).font('Helvetica').text(text, { lineGap: 3 });
      doc.moveDown(0.4);
    }

    function label(key, value) {
      if (!value || (Array.isArray(value) && value.length === 0)) return;
      const val = Array.isArray(value) ? value.join(', ') : value;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.muted).text(`${key}:  `, { continued: true });
      doc.font('Helvetica').fillColor(COLORS.text).text(val, { lineGap: 3 });
      doc.moveDown(0.3);
    }

    function divider() {
      doc.moveDown(0.5);
      doc.moveTo(60, doc.y).lineTo(60 + pageWidth, doc.y).strokeColor(COLORS.divider).lineWidth(0.5).stroke();
      doc.moveDown(0.5);
    }

    function pageHeader(title) {
      doc.addPage();
      doc.fontSize(10).fillColor(COLORS.muted).font('Helvetica')
        .text(`Writer Assistant  ·  ${new Date().toLocaleDateString()}`, { align: 'right' });
      doc.moveDown(0.5);
      heading2(title);
    }

    // ─── Title Page ──────────────────────────────────────────────────

    doc.moveDown(6);
    heading1('Story Structure Document');
    doc.moveDown(0.5);

    const storyTitle = storyData.structure?.genre
      ? `${storyData.structure.genre} Story`
      : 'Untitled Story';

    doc.fontSize(14).fillColor(COLORS.muted).font('Helvetica').text(storyTitle, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor(COLORS.muted).text(`Generated ${new Date().toLocaleDateString()}`, { align: 'center' });

    doc.moveDown(3);
    divider();
    doc.moveDown(1);

    // ─── Story Overview ──────────────────────────────────────────────

    heading2('Story Overview');
    body(storyData.overview || 'No overview provided.');

    if (storyData.structure) {
      const s = storyData.structure;
      doc.moveDown(0.5);
      label('Genre', s.genre);
      label('Themes', s.themes);
      label('Mood / Tone', s.moods);
      label('Core Message', s.messages?.join(' '));
    }

    // ─── Characters ──────────────────────────────────────────────────

    const characters = storyData.characters || [];
    if (characters.length > 0) {
      pageHeader('Characters');
      for (const char of characters) {
        heading3(char.name || 'Unnamed Character');

        label('Traits', char.traits);
        label('Backstory', char.backstory);
        label('Fears', char.fears);
        label('Desires', char.desires);
        label('Voice / Speech', char.voice);
        label('Character Arc', char.arc);

        if (char.scenarios && char.scenarios.length > 0) {
          doc.fontSize(11).fillColor(COLORS.muted).font('Helvetica-Bold').text('Key Scenarios:');
          doc.moveDown(0.2);
          for (const scenario of char.scenarios) {
            doc.fontSize(11).fillColor(COLORS.text).font('Helvetica').text(`• ${scenario}`, { indent: 12, lineGap: 2 });
          }
          doc.moveDown(0.4);
        }

        if (char.suggestions && char.suggestions.length > 0) {
          doc.fontSize(11).fillColor(COLORS.muted).font('Helvetica-Bold').text('Development Notes:');
          doc.moveDown(0.2);
          for (const suggestion of char.suggestions) {
            doc.fontSize(11).fillColor(COLORS.text).font('Helvetica').text(`• ${suggestion}`, { indent: 12, lineGap: 2 });
          }
          doc.moveDown(0.4);
        }

        if (char.notes) {
          body(char.notes);
        }

        divider();
      }
    }

    // ─── Three-Act Structure ─────────────────────────────────────────

    const acts = storyData.structure?.acts;
    if (acts && (acts.one || acts.two || acts.three)) {
      pageHeader('Three-Act Structure');

      if (acts.one) {
        heading3('Act One — Setup');
        body(acts.one);
        doc.moveDown(0.3);
      }
      if (acts.two) {
        heading3('Act Two — Confrontation');
        body(acts.two);
        doc.moveDown(0.3);
      }
      if (acts.three) {
        heading3('Act Three — Resolution');
        body(acts.three);
        doc.moveDown(0.3);
      }
      if (storyData.structure.ending) {
        label('How it Ends', storyData.structure.ending);
      }
    }

    // ─── Scene / Chapter Breakdown ───────────────────────────────────

    const scenes = storyData.scenes || [];
    if (scenes.length > 0) {
      pageHeader('Scene & Chapter Breakdown');

      for (const scene of scenes) {
        const sceneTitle = scene.title || `Scene ${scene.number || ''}`;
        heading3(sceneTitle);
        label('Setting', scene.setting);
        label('Characters', scene.characters);
        label('What Happens', scene.summary);
        label('Scene Turn', scene.turn);
        label('Emotional Tone', scene.tone);
        if (scene.notes) body(scene.notes);
        divider();
      }
    }

    // ─── Writing Style Notes ─────────────────────────────────────────

    if (storyData.writingStyle?.notes) {
      pageHeader('Writing Style Notes');
      body('The following observations were inferred from your messages during the development session:');
      doc.moveDown(0.5);
      const lines = storyData.writingStyle.notes.split('\n').filter(l => l.trim());
      for (const line of lines) {
        doc.fontSize(11).fillColor(COLORS.text).font('Helvetica').text(line.trim(), { lineGap: 3 });
        doc.moveDown(0.2);
      }
    }

    doc.end();
  });
}

module.exports = { generatePDF };
