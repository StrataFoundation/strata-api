#!/bin/bash
docker run -it --rm -d --hostname rabbit --name rabbit -p 15672:15672 -p 5672:5672 rabbitmq:3-management

docker logs -f rabbit