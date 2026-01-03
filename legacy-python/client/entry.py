import click
import os

@click.command()
def start():
    # Directly import and run the main application
    import resygrabber
    resygrabber.menu()

if __name__ == "__main__":
    start()
