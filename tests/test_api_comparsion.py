from __future__ import annotations

import asyncio
import gc
import inspect
import logging
import aiohttp
from src.core.client import Twitch
from src.services.inventory_service import InventoryService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("TestInventory")


async def main() -> None:
    logger.info("=== Spouštím test inventáře a emote/badge bypassu ===")
    
    import src.config as cfg
    
    settings_obj = None
    for attr_name in dir(cfg):
        attr = getattr(cfg, attr_name)
        if inspect.isclass(attr) and any(k in attr_name.lower() for k in ("setting", "config", "options", "parameter")):
            try:
                settings_obj = attr()
                break
            except Exception:
                pass
                
    if settings_obj is None:
        class DefaultSettings:
            connection_quality = 3
            minimum_refresh_interval_minutes = 15
            debug = True
            proxy = None
            headless = True
            language = "cs"
            def __getattr__(self, name):
                return None
        settings_obj = DefaultSettings()

    if not hasattr(settings_obj, "connection_quality"):
        setattr(settings_obj, "connection_quality", 3)
    if not hasattr(settings_obj, "minimum_refresh_interval_minutes"):
        setattr(settings_obj, "minimum_refresh_interval_minutes", 15)

    twitch = Twitch(settings_obj)
    
    # Kompletně ošetřené Dummy GUI pro bezhlavý test
    class DummyStatus:
        def update(self, msg):
            logger.info(f"[GUI Status Mock] {msg}")

    class DummyInv:
        def clear(self):
            pass
        async def add_campaign(self, campaign):
            pass

    class DummyLogin:
        def update(self, *args, **kwargs):
            pass

    class DummyChannels:
        def clear(self):
            pass
        def append(self, *args, **kwargs):
            pass

    class DummyGUI:
        status = DummyStatus()
        inv = DummyInv()
        login = DummyLogin()
        channels = DummyChannels()

    twitch.gui = DummyGUI()

    try:
        # Ověření přihlášení
        if hasattr(twitch, "_auth_service") and twitch._auth_service:
            try:
                await twitch._auth_service.check_login()
            except Exception as e:
                logger.warning(f"check_login proběhl s varováním: {e}")

        logger.info("Přihlášení v pořádku. Spouštím InventoryService.fetch_inventory()...")
        
        service = InventoryService(twitch)
        await service.fetch_inventory()

        logger.info("=== Test úspěšně dokončen ===")
        logger.info(f"Počet načtených a ošetřených kampaní v inventáři: {len(twitch.inventory)}")
        
        for camp in twitch.inventory:
            claimed_drops = sum(1 for d in camp.drops if getattr(d, "claim", False) or getattr(d, "claimed", False))
            total_drops = len(camp.drops)
            logger.info(
                f"  • Kampaň: '{camp.name}' (Hra: {camp.game.name}) -> "
                f"Hotovo dropů: {claimed_drops}/{total_drops}"
            )

    finally:
        logger.info("Provádím úklid a zavírám HTTP relaci...")

        # 1. Storno úlohy údržby spuštěné na pozadí
        if getattr(twitch, "_mnt_task", None) and not twitch._mnt_task.done():
            twitch._mnt_task.cancel()
            try:
                await twitch._mnt_task
            except asyncio.CancelledError:
                pass

        # 2. Zavření hlavní metody klienta (pokud existuje)
        if hasattr(twitch, "close"):
            res = twitch.close()
            if inspect.isawaitable(res):
                await res

        # 3. GC Sweep: Vyhledání a uzamčení VŠECH zapomenutých/anonymních aiohttp relací v paměti
        closed_count = 0
        for obj in gc.get_objects():
            if isinstance(obj, aiohttp.ClientSession) and not obj.closed:
                await obj.close()
                closed_count += 1

        if closed_count > 0:
            logger.info(f"GC úklid: Úspěšně dohledáno a uzavřeno {closed_count} neuzavřených HTTP relací.")

        # 4. Pauza pro dočištění TCP socket handlerů v event loopu
        await asyncio.sleep(0.25)
        logger.info("Úklid dokončen, konektory uzavřeny.")


if __name__ == "__main__":
    asyncio.run(main())
