import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

const WORKER_CONTAINER = 'termicoop-worker-1';

// Este test es destructivo (elimina el worker), así que debe correr en su propio worker
test.describe.configure({ mode: 'serial' });

test.describe('Worker Deletion Manual Test', () => {
    test.setTimeout(60000);

    test.beforeAll(async () => {
        try {
            // Reiniciar servicios Docker para asegurar estado limpio
            await execAsync(`docker compose -f /home/stev/Documentos/repos/Personal/ultimate-terminal/docker-compose.prod.yml restart nexus worker`);
            await new Promise(r => setTimeout(r, 8000));
        } catch (e) {
            console.log('Error reiniciando servicios:', e);
            // Intentar solo iniciar el worker
            try {
                await execAsync(`docker start ${WORKER_CONTAINER}`);
                await new Promise(r => setTimeout(r, 5000));
            } catch (e2) {
                console.log('Worker might already be running');
            }
        }
    });

    test.afterAll(async () => {
        try {
            // Recrear el entorno para futuros tests
            await execAsync(`docker compose -f /home/stev/Documentos/repos/Personal/ultimate-terminal/docker-compose.prod.yml restart nexus worker`);
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            console.error('Failed to restart services:', e);
        }
    });

    test('Should detect offline worker and allow deletion', async ({ page }) => {
        console.log('Navigating to /', page.url());
        await page.goto('/');

        const usernameInput = page.locator('input[name="username"]');
        if (await usernameInput.isVisible()) {
            console.log('Logging in...');
            await usernameInput.fill('admin');
            await page.locator('input[name="password"]').fill('dev-change-me');
            await page.getByRole('button', { name: 'Login' }).click();
        }

        console.log('Verifying worker online...');
        const onlineWorker = page.locator('.worker-item:not(.offline)').first();
        await expect(onlineWorker).toBeVisible({ timeout: 10000 });
        
        const workerName = await onlineWorker.locator('.worker-name').textContent();
        console.log(`Target worker: ${workerName}`);

        console.log('Stopping worker container...');
        await execAsync(`docker stop ${WORKER_CONTAINER}`);

        console.log('Waiting for offline status...');
        const offlineWorker = page.locator('.worker-item.offline', { hasText: workerName! });
        await expect(offlineWorker).toBeVisible({ timeout: 15000 });

        console.log('Deleting worker...');
        
        // Abrir modal de edición de tags
        await offlineWorker.locator('.tag-edit-btn').click();
        const tagModal = page.locator('.modal-overlay').first();
        await expect(tagModal).toBeVisible();
        
        // Clic en "Eliminar Worker" - esto abre el diálogo de confirmación
        const deleteWorkerBtn = tagModal.locator('button.btn-danger', { hasText: 'Eliminar Worker' });
        await expect(deleteWorkerBtn).toBeVisible();
        await deleteWorkerBtn.click();

        // Esperar que aparezca el diálogo de confirmación (reemplaza el modal de tags)
        const dialogModal = page.locator('.dialog-modal');
        await expect(dialogModal).toBeVisible({ timeout: 5000 });
        console.log('Confirmation dialog visible');
        
        // Verificar que el mensaje de confirmación contiene el nombre del worker
        await expect(dialogModal.locator('.dialog-message')).toContainText('Docker-Dev-Worker');
        
        // Clic en botón "Eliminar" dentro del diálogo de confirmación
        const confirmBtn = dialogModal.locator('.dialog-btn.danger', { hasText: 'Eliminar' });
        await expect(confirmBtn).toBeVisible();
        console.log('Clicking confirm button...');
        
        // Interceptar requests para ver qué pasa
        const deleteRequest = page.waitForRequest(req => 
            req.method() === 'DELETE' && req.url().includes('/api/workers/')
        ).catch(() => null);
        
        await confirmBtn.click();
        
        // Esperar un poco a ver si la request se hace
        const req = await Promise.race([
            deleteRequest,
            page.waitForTimeout(3000).then(() => null)
        ]);
        
        if (req) {
            console.log(`DELETE request made to: ${req.url()}`);
            const response = await req.response();
            console.log(`Response status: ${response?.status()}`);
        } else {
            console.log('No DELETE request detected within 3 seconds');
        }

        // Esperar que el worker desaparezca
        console.log('Waiting for worker to disappear...');
        await expect(offlineWorker).not.toBeVisible({ timeout: 15000 });
        console.log('Worker deleted successfully');
    });
});
