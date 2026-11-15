PlaneSpotter

The ultimate aircraft identification game for Discord.

PlaneSpotter is a public Discord bot designed for aviation communities, virtual airlines and aircraft enthusiasts. It challenges members to identify aircraft from photographs, earn points and compete for the top positions on server-wide and global leaderboards.

Features

Aircraft Identification

- Automatically posts aircraft photographs in a configured Discord channel.
- Members submit their answers using an interactive button.
- Answers are entered through a Discord modal.
- Correct answers earn one leaderboard point.
- Incorrect answers do not earn points.
- Automatic answer reveals when the submission period ends.
- Aircraft are randomly selected from a large database.

Extensive Aircraft Database

PlaneSpotter aims to feature thousands of aircraft, including:

- Commercial passenger aircraft
- Cargo aircraft
- Military aircraft
- Fighter jets and bombers
- Historic and vintage aircraft
- Regional aircraft
- Turboprops
- Private and business jets
- Helicopters
- Experimental aircraft
- Supersonic aircraft
- Training aircraft

Aircraft manufacturers include Airbus, Boeing, McDonnell Douglas, Lockheed, Douglas, Embraer, Bombardier, ATR, Fokker, de Havilland, Cessna, Antonov, Tupolev and many more.

Leaderboards

Compete with other aviation enthusiasts through:

- Server leaderboard
- Global leaderboard
- Weekly leaderboard
- All-time leaderboard
- Individual player profiles
- Total correct answers and player statistics

Easy Server Configuration

Administrators can configure PlaneSpotter using "/setup".

Available settings include:

- Aircraft challenge channel
- Automatic posting intervals
- Answer submission duration
- Aircraft difficulty
- Automatic answer reveals
- Enable or disable automatic challenges

Configuration is saved separately for each Discord server.

Commands

Command| Description| Permission
"/setup"| Configure PlaneSpotter| Administrator
"/leaderboard"| View player rankings| Everyone
"/profile"| View player statistics| Everyone
"/help"| View available commands| Everyone

How It Works

1. An administrator invites PlaneSpotter and runs "/setup".
2. The administrator selects the game channel and configures the intervals.
3. PlaneSpotter automatically posts an aircraft photograph.
4. Members press the submission button.
5. A modal opens where they enter the aircraft's name.
6. Correct answers receive one point.
7. The correct aircraft is revealed when the round finishes.
8. Leaderboards update automatically.

Technology

PlaneSpotter is intended to use:

- Node.js
- Discord.js
- Discord Interactions
- A persistent database for server configurations and player statistics

Hosting

PlaneSpotter requires a continuously running hosting environment to support automatic aircraft challenges and scheduled posts.

Environment variables and database configuration will be documented as the project develops.

Project Status

Development in progress.

PlaneSpotter is being developed as a public Discord bot available to aviation communities, virtual airlines and Discord servers.

Licence

A licence will be added before public distribution.
