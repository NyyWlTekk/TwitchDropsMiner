#!/usr/bin/env python3
"""
TwitchDropsMiner - Main entry point

This is a simple launcher that runs the src package as a module.
All application code is in the src/ directory.
"""
import logging

# Nastaví root logger na DEBUG
logging.getLogger().setLevel(logging.DEBUG)
logging.getLogger("src.services.stream_selector").setLevel(logging.DEBUG)

if __name__ == "__main__":
    import runpy

    # Run the src package as a module
    runpy.run_module("src", run_name="__main__")
