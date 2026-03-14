const acme = require('acme-client');
const fs = require('fs');
const path = require('path');
const https = require('https');

// CONFIGURAÇÃO
const DOMAIN = 'tocachat.duckdns.org';
const DUCKDNS_DOMAIN = 'tocachat';
const DUCKDNS_TOKEN = '7e1b74c3-668c-490e-9ac6-5586864ece4e';
const EMAIL = 'lucasbastosrezende@gmail.com'; // E-mail para avisos de expiração

const CERTS_DIR = path.join(__dirname, 'certs');

// Garantir diretório de certificados
if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR);
}

async function updateDuckDNS(txt) {
    return new Promise((resolve, reject) => {
        const value = txt || '';
        const url = `https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&txt=${value}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (data === 'OK') {
                    console.log(`[DuckDNS] TXT record atualizado para: ${value || '(vazio)'}`);
                    resolve();
                } else {
                    reject(new Error(`DuckDNS falhou: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function run() {
    try {
        console.log('--- Iniciando obtenção de certificado Let\'s Encrypt ---');
        
        const client = new acme.Client({
            directoryUrl: acme.directory.letsencrypt.production,
            accountKey: await acme.crypto.createPrivateKey()
        });

        /* Create CSR */
        const [key, csr] = await acme.crypto.createCsr({
            commonName: DOMAIN
        });

        /* Certificate obtain */
        const cert = await client.auto({
            csr,
            email: EMAIL,
            termsOfServiceAgreed: true,
            challengePriority: ['dns-01'],
            challengeCreateFn: async (authz, challenge, keyAuthorization) => {
                if (challenge.type === 'dns-01') {
                    console.log(`[ACME] Criando desafio DNS para ${authz.identifier.value}`);
                    await updateDuckDNS(keyAuthorization);
                    console.log('[DuckDNS] Aguardando 60 segundos para propagação...');
                    await new Promise(r => setTimeout(r, 60000));
                }
            },
            challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
                if (challenge.type === 'dns-01') {
                    console.log(`[ACME] Removendo desafio DNS para ${authz.identifier.value}`);
                    await updateDuckDNS('');
                }
            }
        });

        /* Save files */
        fs.writeFileSync(path.join(CERTS_DIR, 'privkey.pem'), key);
        fs.writeFileSync(path.join(CERTS_DIR, 'fullchain.pem'), cert);
        
        console.log('--- SUCESSO! Certificados salvos em /certs ---');
        console.log('- privkey.pem');
        console.log('- fullchain.pem');
    } catch (err) {
        console.error('--- ERRO AO OBTER CERTIFICADO ---');
        console.error(err);
        process.exit(1);
    }
}

run();
