import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

const languages = {
    bash,
    sh: bash,
    shell: bash,
    zsh: bash,
    css,
    diff,
    go,
    javascript,
    js: javascript,
    jsx,
    json,
    markdown,
    md: markdown,
    markup,
    html: markup,
    xml: markup,
    python,
    py: python,
    rust,
    rs: rust,
    'shell-session': shellSession,
    terminal: shellSession,
    console: shellSession,
    tsx,
    typescript,
    ts: typescript,
    yaml,
    yml: yaml
};

Object.entries(languages).forEach(([name, language]) => {
    SyntaxHighlighter.registerLanguage(name, language);
});

export { SyntaxHighlighter };
